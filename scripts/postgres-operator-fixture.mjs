/** Isolate this serial synthetic fixture; never change the operational admission guard. */
export async function withOperatorTestEnvironment(run, injected = {}) {
  const inherited = process.env;
  const names = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "CI"];
  process.env = {
    ...Object.fromEntries(
      names.filter((name) => Object.hasOwn(inherited, name)).map((name) => [name, inherited[name]]),
    ),
    ...injected,
  };
  try {
    return await run();
  } finally {
    process.env = inherited;
  }
}
