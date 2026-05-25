using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

namespace DvMod.RemoteDispatch
{
    public class Updater : MonoBehaviour
    {
        public void Start()
        {
            StartCoroutine(CheckPlayerTransformCoro());
            StartCoroutine(CheckTrainsetsCoro());
            StartCoroutine(DeferredEventsCoro());
        }

        private static GameObject? rootObject;

        public static void Create()
        {
            if (rootObject == null)
            {
                rootObject = new GameObject();
                GameObject.DontDestroyOnLoad(rootObject);
                rootObject.AddComponent<Updater>();
            }
        }

        public static void Destroy()
        {
            if (rootObject != null)
            {
                GameObject.Destroy(rootObject);
                rootObject = null;
            }
        }

        private IEnumerator CheckPlayerTransformCoro()
        {
            while (true)
            {
                yield return WaitFor.Seconds(0.1f);
                PlayerData.CheckTransform();
            }
        }

        // Tracks which trainset IDs were moving last poll cycle so we can
        // send one final dirty update the frame a trainset transitions to stationary.
        private readonly HashSet<int> _movingTrainsetIds = new HashSet<int>();

        private IEnumerator CheckTrainsetsCoro()
        {
            while (true)
            {
                // Poll at 4 Hz instead of every frame — position updates 4×/sec are
                // smooth for the web dispatcher map and costs 1/15th the CPU budget.
                yield return WaitFor.Seconds(0.25f);

                var currentlyMoving = new HashSet<int>();
                foreach (var trainset in Trainset.allSets)
                {
                    if (trainset.firstCar == null) continue;

                    if (!trainset.firstCar.isStationary)
                    {
                        currentlyMoving.Add(trainset.id);
                        CarUpdater.MarkTrainsetAsDirty(trainset);
                    }
                }

                // Trainsets that just stopped: push one final position update so the
                // web map shows the correct resting position, then stop polling them.
                foreach (var trainset in Trainset.allSets)
                {
                    if (_movingTrainsetIds.Contains(trainset.id) && !currentlyMoving.Contains(trainset.id))
                        CarUpdater.MarkTrainsetAsDirty(trainset);
                }

                _movingTrainsetIds.Clear();
                foreach (int id in currentlyMoving)
                    _movingTrainsetIds.Add(id);
            }
        }

        private IEnumerator DeferredEventsCoro()
        {
            while (true)
            {
                while (taskQueue.TryDequeue(out var action))
                    action();
                // 50 ms latency is imperceptible for junction toggles and loco commands,
                // and avoids draining the queue 60+ times per second when idle.
                yield return WaitFor.Seconds(0.05f);
            }
        }

        private static readonly ConcurrentQueue<Action> taskQueue = new ConcurrentQueue<Action>();

        public static Task RunOnMainThread(Action action)
        {
            var tcs = new TaskCompletionSource<bool>();
            taskQueue.Enqueue(() =>
            {
                try
                {
                    action();
                    tcs.SetResult(true);
                }
                catch (Exception e)
                {
                    tcs.SetException(e);
                }
            });
            return tcs.Task;
        }

        public static Task<T> RunOnMainThread<T>(Func<T> func)
        {
            var tcs = new TaskCompletionSource<T>();
            taskQueue.Enqueue(() =>
            {
                try
                {
                    tcs.SetResult(func());
                }
                catch (Exception e)
                {
                    tcs.SetException(e);
                }
            });
            return tcs.Task;
        }
    }
}
