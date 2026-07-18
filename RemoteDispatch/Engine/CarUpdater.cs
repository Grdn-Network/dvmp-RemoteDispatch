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

        private static long _snapshotSeq;
        private static int _lastSerialiseErrorTick; // Environment.TickCount: worker-thread safe

        public static void MarkTrainsetAsDirty(Trainset trainset)
        {
            // Main thread: gather raw values only (Unity reads live in CarData.From).
            // JSON building and string serialisation are pure CPU over those values,
            // so they run on the thread pool; with dozens of moving cars this was the
            // single biggest slice of RemoteDispatch's frame cost. The sequence gate
            // in Sessions keeps out-of-order worker completions from ever replacing a
            // newer snapshot with an older one.
            var gathered = CarData.GatherTrainset(trainset);
            if (gathered.Count == 0)
                return;

            var tag = $"trainset-{trainset.id}";
            var seq = System.Threading.Interlocked.Increment(ref _snapshotSeq);
            System.Threading.Tasks.Task.Run(() =>
            {
                try
                {
                    var dict = new System.Collections.Generic.Dictionary<string, Newtonsoft.Json.Linq.JObject>();
                    foreach (var pair in gathered)
                        dict[pair.Key] = pair.Value.ToJson();
                    Sessions.AddTagWithCacheIfNewest(tag, seq, Newtonsoft.Json.JsonConvert.SerializeObject(dict));
                }
                catch (System.Exception e)
                {
                    // No Unity APIs here: this runs on a thread-pool worker.
                    int now = System.Environment.TickCount;
                    if (now - _lastSerialiseErrorTick < 30000) return;
                    _lastSerialiseErrorTick = now;
                    Main.Log($"trainset snapshot serialisation failed: {e.GetType().Name}: {e.Message}");
                }
            });
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
