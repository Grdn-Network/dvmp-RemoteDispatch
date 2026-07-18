using DV.Logic.Job;
using DV.ThingTypes;
using DV.ThingTypes.TransitionHelpers;
using DV.Utils;
using HarmonyLib;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace DvMod.RemoteDispatch
{
    public static class JobData
    {
        // Built lazily and defensively: the old static-initializer version ran at
        // whatever moment the class was first touched. If that was before the
        // JobsManager existed, the type initializer threw and EVERY later use of
        // JobData threw TypeInitializationException — which killed the update
        // stream while a page refresh (a different path) still half-worked.
        private static Dictionary<TrainCar, string>? jobIdForCarBacking;
        private static Dictionary<string, Job> jobForId = new Dictionary<string, Job>();

        private const JobLicenses LicensesToExport =
          JobLicenses.Hazmat1 | JobLicenses.Hazmat2 | JobLicenses.Hazmat3 |
          JobLicenses.Military1 | JobLicenses.Military2 | JobLicenses.Military3 |
          JobLicenses.TrainLength1 | JobLicenses.TrainLength2;

        private static Dictionary<TrainCar, string> JobIdCarMap
        {
            get
            {
                if (jobIdForCarBacking == null)
                    jobIdForCarBacking = BuildJobIdForCar();
                return jobIdForCarBacking;
            }
        }

        public static string? JobIdForCar(TrainCar car)
        {
            JobIdCarMap.TryGetValue(car, out var jobId);
            return jobId;
        }

        public static Job? JobForCar(TrainCar car)
        {
            var jobId = JobIdForCar(car);
            if (jobId == null)
                return null;
            return JobForId(jobId);
        }

        private static Dictionary<TrainCar, string> BuildJobIdForCar()
        {
            var map = new Dictionary<TrainCar, string>();
            try
            {
                var jobsManager = SingletonBehaviour<JobsManager>.Instance;
                if (jobsManager == null)
                    return map;
                foreach (var kvp in jobsManager.jobToJobCars)
                {
                    foreach (var car in kvp.Value)
                    {
                        try
                        {
                            var trainCar = car.TrainCar();
                            if (trainCar != null)
                                map[trainCar] = kvp.Key.ID;
                        }
                        catch
                        {
                            // a logic car whose physical car is gone; skip it
                        }
                    }
                }
            }
            catch (Exception e)
            {
                Main.DebugLog($"job-car map build failed, retrying next access: {e.Message}");
                return map;
            }
            return map;
        }

        public static Job? JobForId(string jobId)
        {
            if (jobForId.TryGetValue(jobId, out var job))
                return job;
            jobForId = BuildJobForId();
            jobForId.TryGetValue(jobId, out job);
            return job;
        }

        // Indexer assignment, never ToDictionary: two Job objects claiming the same ID
        // (seen across world reloads) made ToDictionary throw, which took the whole
        // "jobs" tag down with it. allJobs is included because carless jobs (Derail
        // Logistics Engine hauls before cars attach) never appear in jobToJobCars.
        private static Dictionary<string, Job> BuildJobForId()
        {
            var map = new Dictionary<string, Job>();
            try
            {
                var jobsManager = SingletonBehaviour<JobsManager>.Instance;
                if (jobsManager == null)
                    return map;
                void AddAll(IEnumerable<Job>? jobs)
                {
                    if (jobs == null) return;
                    foreach (var job in jobs)
                    {
                        if (job?.ID == null) continue;
                        if (job.State != JobState.Available && job.State != JobState.InProgress) continue;
                        map[job.ID] = job;
                    }
                }
                AddAll(jobsManager.jobToJobCars.Keys);
                AddAll(jobsManager.allJobs);
            }
            catch (Exception e)
            {
                Main.DebugLog($"job map build failed, retrying next access: {e.Message}");
            }
            return map;
        }

        public static Dictionary<string, JObject> GetAllJobData()
        {
            static IEnumerable<JObject> PassengerJson(TaskData sequenceTask)
            {
                var sequence = sequenceTask.nestedTasks.Select(task => task.GetTaskData()).ToList();

                string startTrackId = sequence[0].destinationTrack.ID.FullDisplayID;

                for (int i = 1; i < sequence.Count; i++)
                {
                    var task = sequence[i];
                    bool isRuralTask = task.type == (TaskType)42;

                    bool isRuralUnload = isRuralTask && !((dynamic)task).isLoading;
                    if ((task.warehouseTaskType != WarehouseTaskType.Unloading) && !isRuralUnload)
                    {
                        // skip everything but unload tasks
                        continue;
                    }

                    string destTrackId;

                    if (isRuralTask)
                    {
                        destTrackId = ((dynamic)task).stationId;
                    }
                    else
                    {
                        destTrackId = task.destinationTrack.ID.FullDisplayID;
                    }

                    yield return new JObject()
                    {
                        { "startTrack", startTrackId },
                        { "destinationTrack", destTrackId },
                        { "cars", new JArray(task.cars.Select(car => car.ID)) }
                    };

                    startTrackId = destTrackId;
                }
            }
            static IEnumerable<TaskData> FlattenToTransport(TaskData data)
            {
                if (data.type == TaskType.Transport)
                {
                    yield return data;
                }
                else if (data.nestedTasks != null)
                {
                    foreach (var nested in data.nestedTasks)
                    {
                        foreach (var task in FlattenToTransport(nested.GetTaskData()))
                            yield return task;
                    }
                }
            }
            static IEnumerable<TaskData> FlattenMany(IEnumerable<TaskData> data) => data.SelectMany(FlattenToTransport);
            static JObject TaskToJson(TaskData data) => new JObject(
                new JProperty("startTrack", data.startTrack?.ID?.FullDisplayID),
                new JProperty("destinationTrack", data.destinationTrack?.ID?.FullDisplayID),
                new JProperty("cars", (data.cars ?? new List<Car>()).Select(car => car.ID))
            );
            static JArray RequiredLicenses(Job job) => JArray.FromObject(
                Enum.GetValues(typeof(JobLicenses))
                    .OfType<JobLicenses>()
                    .Where(v => (job.requiredLicenses & LicensesToExport & v) != JobLicenses.Basic)
                    .Select(v => Enum.GetName(typeof(JobLicenses), v))
            );
            static float TotalLength(TaskData task) => task.cars.Sum(car => car.length);
            static float TotalMass(TaskData task) => task.cars.Sum(car => car.carType.parentType.mass)
                + ((task.cargoTypePerCar == null)
                ? 0f
                : task.cars.Zip(task.cargoTypePerCar, (car, cargoType) => car.capacity * cargoType.ToV2().massPerUnit).Sum());

            static JObject JobToJson(Job job)
            {
                IEnumerable<JObject> taskJson;
                TaskData? mainTask;

                if (job.jobType <= JobType.ComplexTransport)
                {
                    // normal job
                    var flattenedTasks = FlattenMany(job.tasks.Select(task => task.GetTaskData())).ToArray();
                    mainTask = flattenedTasks.Length == 0
                        ? null
                        : job.jobType == JobType.ShuntingLoad ? flattenedTasks.Last() : flattenedTasks.First();

                    taskJson = flattenedTasks.Select(TaskToJson);
                }
                else
                {
                    // passenger
                    var sequenceTask = job.tasks[0].GetTaskData();
                    mainTask = sequenceTask.nestedTasks[0].GetTaskData();
                    taskJson = PassengerJson(sequenceTask);
                }

                var json = new JObject(
                    new JProperty("originYardId", job.chainData?.chainOriginYardId),
                    new JProperty("destinationYardId", job.chainData?.chainDestinationYardId),
                    new JProperty("tasks", taskJson),
                    new JProperty("requiredLicenses", RequiredLicenses(job)),
                    new JProperty("length", mainTask == null ? 0f : TotalLength(mainTask)),
                    new JProperty("mass", mainTask == null ? 0f : TotalMass(mainTask) / 1000),
                    new JProperty("basePayment", job.GetBasePaymentForTheJob()),
                    new JProperty("isActive", job.State == JobState.InProgress));
                DleBridge.Decorate(job.ID, json);
                return json;
            }

            // ensure cache is updated
            JobForId("");
            var result = new Dictionary<string, JObject>();
            foreach (var kvp in jobForId)
            {
                // One malformed job must never empty the whole job list (and, worse,
                // kill the update batch carrying the train positions).
                try
                {
                    result[kvp.Key] = JobToJson(kvp.Value);
                }
                catch (Exception e)
                {
                    Main.DebugLog($"job {kvp.Key} could not be serialized and was skipped: {e.GetType().Name}: {e.Message}");
                }
            }
            return result;
        }

        public static string GetAllJobDataJson()
        {
            return JsonConvert.SerializeObject(GetAllJobData());
        }

        /// <summary>
        /// Booklet data for Derail Logistics Engine hauls, read via reflection so
        /// RemoteDispatch keeps zero compile-time dependency on DLE. DLE zeroes the
        /// vanilla payment (it pays through its own gate on delivery) and its hauls
        /// are carless until crews bring empties, so without this overlay the job
        /// list shows $0 and 0 cars for every DLE haul. Fails soft: DLE absent or
        /// reshaped means jobs render exactly as before.
        /// </summary>
        private static class DleBridge
        {
            private static bool resolved;
            private static object? jobDefinitions;          // Dictionary<string, StaticDirectHaulJobDefinition>
            private static MethodInfo? dictTryGetValue;
            private static FieldInfo? payField;
            private static FieldInfo? cargoField;
            private static FieldInfo? plannedField;
            private static FieldInfo? unpaidField;
            private static object? assignmentStore;         // AssignmentStore.Instance
            private static MethodInfo? assignmentGet;
            private static FieldInfo? assignmentPlayer;

            private static void Resolve()
            {
                if (resolved) return;
                try
                {
                    Assembly? dle = null;
                    foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                    {
                        if (asm.GetName().Name == "DerailLogisticsEngine") { dle = asm; break; }
                    }
                    if (dle == null) return; // DLE not installed; try again next time

                    var defType = dle.GetType("DLE.Jobs.StaticDirectHaulJobDefinition");
                    var defsField = defType?.GetField("jobDefinitions", BindingFlags.Public | BindingFlags.Static);
                    jobDefinitions = defsField?.GetValue(null);
                    if (jobDefinitions != null)
                    {
                        dictTryGetValue = jobDefinitions.GetType().GetMethod("TryGetValue");
                        payField = defType!.GetField("deliveryPayment");
                        cargoField = defType.GetField("transportedCargo");
                        plannedField = defType.GetField("plannedCarCount");
                        unpaidField = defType.GetField("unpaidMove");
                    }

                    var storeType = dle.GetType("DLE.Dispatch.AssignmentStore");
                    assignmentStore = storeType?.GetField("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);
                    assignmentGet = storeType?.GetMethod("Get");
                    var assignmentType = dle.GetType("DLE.Dispatch.AssignmentStore+Assignment");
                    assignmentPlayer = assignmentType?.GetField("Player");

                    resolved = jobDefinitions != null;
                    if (resolved)
                        Main.Log("Derail Logistics Engine detected; job list shows DLE booklet data.");
                }
                catch (Exception e)
                {
                    Main.DebugLog($"DLE bridge resolve failed: {e.Message}");
                    resolved = true; // shape unrecognised; do not rescan every job tick
                }
            }

            public static void Decorate(string jobId, JObject json)
            {
                try
                {
                    Resolve();
                    if (jobDefinitions == null || dictTryGetValue == null) return;

                    var args = new object?[] { jobId, null };
                    if (!(bool)dictTryGetValue.Invoke(jobDefinitions, args)) return;
                    var def = args[1];
                    if (def == null) return;

                    if (payField?.GetValue(def) is float pay)
                        json["basePayment"] = pay; // the real haul pay, not the zeroed vanilla one
                    if (unpaidField?.GetValue(def) is bool unpaid && unpaid)
                    {
                        json["basePayment"] = 0f;
                        json["dleUnpaid"] = true;
                    }
                    var cargo = cargoField?.GetValue(def)?.ToString();
                    if (!string.IsNullOrEmpty(cargo))
                        json["dleCargo"] = cargo;
                    if (plannedField?.GetValue(def) is int planned && planned > 0)
                        json["dlePlannedCars"] = planned;

                    if (assignmentStore != null && assignmentGet != null)
                    {
                        var assignment = assignmentGet.Invoke(assignmentStore, new object[] { jobId });
                        var player = assignment == null ? null : assignmentPlayer?.GetValue(assignment) as string;
                        if (!string.IsNullOrEmpty(player))
                            json["dleAssigned"] = player;
                    }
                }
                catch (Exception e)
                {
                    Main.DebugLog($"DLE bridge decorate failed for {jobId}: {e.Message}");
                }
            }
        }

        public static class JobPatches
        {
            [HarmonyPatch(typeof(JobChainController), nameof(JobChainController.UpdateTrainCarPlatesOfCarsOnJob))]
            public static class UpdateTrainCarPlatesOfCarsOnJobPatch
            {
                public static void Postfix(JobChainController __instance, string jobId)
                {
                    foreach (Car car in __instance.carsForJobChain)
                    {
                        var trainCar = car.TrainCar();

                        if (jobId.Length == 0)
                            JobIdCarMap.Remove(trainCar);
                        else
                            JobIdCarMap[trainCar] = jobId;
                        Sessions.AddTag("jobs");
                    }
                }
            }

            // Derail Logistics Engine attaches cars to a job MID-LIFE (crews bring
            // empties to the loading track) and stamps the plates per car, not through
            // the chain-level call above. Without this hook the dispatcher map never
            // learns those cars belong to a job: no colour, no destination, no job id.
            [HarmonyPatch(typeof(TrainCar), nameof(TrainCar.UpdateJobIdOnCarPlates))]
            public static class UpdateJobIdOnCarPlatesPatch
            {
                public static void Postfix(TrainCar __instance, string jobId)
                {
                    try
                    {
                        if (string.IsNullOrEmpty(jobId))
                            JobIdCarMap.Remove(__instance);
                        else
                            JobIdCarMap[__instance] = jobId;
                        Sessions.AddTag("jobs");
                        CarUpdater.MarkCarAsDirty(__instance);
                    }
                    catch (Exception e)
                    {
                        Main.DebugLog($"per-car plate hook failed: {e.Message}");
                    }
                }
            }

            public static void UpdateJobsFromPersistentJobs(Job job)
            {
                Main.DebugLog("Persistent Jobs sent update for job " + job.ID);
                Sessions.AddTag("jobs");
            }
            [HarmonyPatch(typeof(Job))]
            public static class UpdateJobStatePatches
            {
                [HarmonyPostfix]
                [HarmonyPatch(nameof(Job.TakeJob))]
                public static void TakeJobPostfix(Job __instance, bool takenViaLoadGame)
                {
                    if (!takenViaLoadGame)
                    {
                        Sessions.AddTag("jobs");
                    }
                }
            }
        }
    }
}
