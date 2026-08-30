# Benchmarks

Run the representative benchmark suite with:

```sh
yarn bench
```

The suite builds the production ESM bundle before measuring CPU-bound path and cancellation operations alongside filesystem-backed directory walking and executable lookup. Results are the median of nine samples to reduce scheduler and filesystem noise.

Performance changes should only be retained when they are repeatable and meaningful. As a working threshold, require at least a 10% throughput improvement in the affected benchmark without a material regression elsewhere. Re-run the full test, typecheck, lint, and build checks after changing implementation code.

## Optimization results

These results were measured on Node v24.17.0 on Windows x64. The baseline (`03981f8`) and optimized implementation (`69616f6`) were built and run in separate worktrees on the same warmed host. Each value is the median of nine samples.

| Benchmark | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| Path properties | 3,931,386 ops/s | 230,574,130 ops/s | 58.6x |
| Path match | 473,915 ops/s | 18,263,906 ops/s | 38.5x |
| getRuntimeInfo | 2,787,318 ops/s | 9,273,324 ops/s | 3.33x |
| Cancellation register/unregister | 3,645,670 ops/s | 4,188,096 ops/s | +14.9% |
| Cancellation dispatch (5 callbacks) | 511,961 ops/s | 556,214 ops/s | +8.6% |
| Path walk (40 dirs, 400 files) | 73 ops/s | 154 ops/s | 2.11x |

Unchanged control cases (`Path` construction and `joinpath`) remained within 1% of baseline. The executable lookup result was treated as filesystem noise because its implementation did not change.

## Feature baselines

The following baselines were recorded after adding the Node resource-management features. They were measured on Node v24.17.0 on Windows x64 using the same median-of-nine methodology.

| Benchmark | Throughput |
| --- | ---: |
| collectStream (1 MiB) | 2,947 ops/s |
| Lifecycle shutdown (5 handlers) | 277,853 ops/s |
| watchPath startup/cancel | 7,733 ops/s |
| Managed process capture | 18 ops/s |
| Application directory mapping | 70,757 ops/s |
| TCP port reserve/release | 1,562 ops/s |
| Durable atomic write (4 KiB) | 230 ops/s |

Managed-process throughput is dominated by starting a fresh Node process. The atomic-write case includes file flush, rename, and parent-directory synchronization; disabling durability options is intentionally not used as the baseline.
