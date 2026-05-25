using DV.LocoRestoration;
using DV.RemoteControls;
using DV.Simulation.Controllers;
using DV.ThingTypes;
using DV.Utils;
using HarmonyLib;
using System.Linq;

namespace DvMod.RemoteDispatch
{
    public static class CarUpdater
    {
        public static void ForceCarRefresh()
        {
            Sessions.AddTag("cars");
        }

        public static void MarkCarAsDirty(TrainCar car)
        {
            Sessions.AddTag($"carguid-{car.CarGUID}");
        }

        [HarmonyPatch(typeof(RemoteControllerModule), nameof(RemoteControllerModule.Init))]
        public static class RemoteControllerModuleInitPatch
        {
            public static void Postfix(RemoteControllerModule __instance)
            {
                var trainCar = TrainCar.Resolve(__instance.gameObject);
                var overrider = __instance.controlsOverrider;
                var controls = new OverridableBaseControl[]
                {
                    overrider.Brake,
                    overrider.IndependentBrake,
                    overrider.Reverser,
                    overrider.Throttle,
                };

                foreach (var control in controls.Where(c => c != null))
                {
                    control.ControlUpdated += _ => MarkCarAsDirty(trainCar);
                }
            }
        }

        public static void MarkTrainsetAsDirty(Trainset trainset)
        {
            if (trainset.cars.Find(car => CarData.ShouldReturnTrainCar(car, true)) == null)
                return;

            // Serialise on the main thread right now (we're inside a coroutine).
            // Caching the result means the HTTP response thread can serve it without
            // a blocking RunOnMainThread call, cutting response latency significantly
            // when Unity's main thread is busy with physics or rendering.
            var tag = $"trainset-{trainset.id}";
            var json = CarData.SerialiseTrainsetOnMainThread(trainset);
            Sessions.AddTagWithCache(tag, json);
        }

        public static void Start()
        {
            CarSpawner carSpawner = SingletonBehaviour<CarSpawner>.Instance;
            if (carSpawner == null)
            {
                Main.DebugLog($"Tried to start {nameof(CarUpdater)} before {nameof(CarSpawner)} was initialized!");
                return;
            }

            carSpawner.CarSpawned += OnCarsChanged;
            carSpawner.CarAboutToBeDeleted += OnCarsChanged;

            foreach (var controller in LocoRestorationController.allLocoRestorationControllers)
                controller.StateChanged += OnRestorationStateChanged;
        }

        public static void Stop()
        {
            CarSpawner carSpawner = SingletonBehaviour<CarSpawner>.Instance;
            if (carSpawner == null)
                return;
            carSpawner.CarSpawned -= OnCarsChanged;
            carSpawner.CarAboutToBeDeleted -= OnCarsChanged;

            foreach (var controller in LocoRestorationController.allLocoRestorationControllers)
                controller.StateChanged -= OnRestorationStateChanged;
        }

        private static void OnCarsChanged(TrainCar trainCar)
        {
            Sessions.AddTag("cars");
        }

        private static void OnRestorationStateChanged(LocoRestorationController controller, TrainCarLivery livery, LocoRestorationController.RestorationState newState)
        {
            if (Main.settings.showUndiscoveredLocomotives)
                return; // already sent to client during initialization

            if (newState == LocoRestorationController.RestorationState.S3_RerailedCars)
                OnCarsChanged(controller.loco);
        }
    }
}
