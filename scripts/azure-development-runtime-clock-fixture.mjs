// Source-only controlled time: native elapsed time plus the finite test hold offset.
export function runtimeClockFixture({ wallTime = Date.now(), offset = () => 0 } = {}) {
  const NativeDate = globalThis.Date;
  const nativeHrtime = process.hrtime.bigint;
  const nativePerformance = globalThis.performance;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const monotonicOrigin = nativeHrtime();
  const day = new NativeDate(wallTime);
  // Same-day admission needs the complete two-hour fixture lifecycle on every UTC run.
  const wallOrigin = NativeDate.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
  const controlledWall = () =>
    wallOrigin + Number((nativeHrtime() - monotonicOrigin) / 1_000_000n) + offset();
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [controlledWall()]);
    },
    get(target, key, receiver) {
      return key === "now" ? controlledWall : Reflect.get(target, key, receiver);
    },
    apply() {
      return new NativeDate(controlledWall()).toString();
    },
  });
  process.hrtime.bigint = () => nativeHrtime() + BigInt(offset()) * 1_000_000n;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: new Proxy(nativePerformance, {
      get(target, key) {
        if (key === "now") return () => nativePerformance.now() + offset();
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  return () => {
    globalThis.Date = NativeDate;
    process.hrtime.bigint = nativeHrtime;
    Object.defineProperty(globalThis, "performance", descriptor);
  };
}
