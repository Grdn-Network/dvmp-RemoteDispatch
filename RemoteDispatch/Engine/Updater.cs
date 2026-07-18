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

        // A coroutine that lets an exception escape is DEAD: Unity stops it silently
        // and that update stream never runs again for the session. Every loop body
        // below is guarded; failures log (throttled) instead of killing the stream.
        private static float lastCoroErrorLogged;

        private static void LogCoroError(string where, Exception e)
        {
            if (Time.unscaledTime - lastCoroErrorLogged < 30f) return;
            lastCoroErrorLogged = Time.unscaledTime;
            Main.Log($"{where} failed (stream continues): {e.GetType().Name}: {e.Message}");
        }

        private IEnumerator CheckPlayerTransformCoro()
        {
            while (true)
            {
                yield return WaitFor.Seconds(Main.settings.lightPlayerPolling ? 0.25f : 0.1f);
                try { PlayerData.CheckTransform(); }
                catch (Exception e) { LogCoroError(nameof(CheckPlayerTransformCoro), e); }
            }
        }

        // Tracks which trainset IDs were moving last poll cycle so we can
        // send one final dirty update the frame a trainset transitions to stationary.
        private readonly HashSet<int> _movingTrainsetIds = new HashSet<int>();
        private int _pollCount;

        private IEnumerator CheckTrainsetsCoro()
        {
            while (true)
            {
                // Position rate comes from settings (default 2/sec): every push gathers
                // and serialises all moving trainsets, so this knob IS the mod's main
                // frame cost. The gather stays on this thread; JSON goes to workers.
                int hz = Math.Max(1, Math.Min(4, Main.settings.positionUpdatesPerSecond));
                yield return WaitFor.Seconds(1f / hz);

                try
                {
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

                    // Loco positions for the "[L-014] Name" player labels, ~1 Hz.
                    if (++_pollCount % hz == 0)
                        PlayerData.RefreshLocoCache();
                }
                catch (Exception e)
                {
                    LogCoroError(nameof(CheckTrainsetsCoro), e);
                }
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
