# Benchmarks

Run the representative benchmark suite with:

```sh
yarn bench
```

The suite builds the production ESM bundle before measuring CPU-bound path and cancellation operations alongside filesystem-backed directory walking and executable lookup. Results are the median of nine samples to reduce scheduler and filesystem noise.

Performance changes should only be retained when they are repeatable and meaningful. As a working threshold, require at least a 10% throughput improvement in the affected benchmark without a material regression elsewhere. Re-run the full test, typecheck, lint, and build checks after changing implementation code.
