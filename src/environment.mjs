const SECRETISH = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACTIONS_ID_TOKEN)/i;

export function sanitizedExecutionEnv(extra = {}) {
  const allowed = ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','LC_CTYPE','TZ','TMPDIR','TMP','TEMP','SHELL','XDG_CACHE_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','SystemRoot','SYSTEMROOT','WINDIR','SystemDrive','ComSpec','COMSPEC','PATHEXT','USERPROFILE','LOCALAPPDATA','APPDATA','VIRTUAL_ENV','UV_CACHE_DIR'];
  const env = { CI: 'true', BRIDGE_EXECUTION: '1' };
  for (const key of allowed) if (process.env[key] !== undefined && !SECRETISH.test(key)) env[key] = process.env[key];
  for (const [key, value] of Object.entries(extra)) env[key] = String(value);
  return env;
}
