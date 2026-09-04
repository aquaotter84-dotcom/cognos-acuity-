// Structured logger — emits one JSON log line per entry. console output is captured as function logs.

export function createLogger(component = "system") {
  function emit(level, message, fields = {}) {
    const entry = { ts: new Date().toISOString(), level, component, message, ...fields };
    console.log(JSON.stringify(entry));
  }
  return {
    debug: (m, f = {}) => emit("debug", m, f),
    info: (m, f = {}) => emit("info", m, f),
    warn: (m, f = {}) => emit("warn", m, f),
    error: (m, f = {}) => emit("error", m, f),
    child: (c) => createLogger(`${component}:${c}`)
  };
}