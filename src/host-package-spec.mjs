// One host package contract shared by packaging and durable service installation.
export const HOST_VERSION='0.4.0-preview.1';
export const HOST_PACKAGE_NAME='@dashideyizhizuo/bridge-host';
export const HOST_SDK_VERSION='2.3.1';
export const DEFAULT_HOST_ENDPOINT='https://bridge.example.invalid/mcp';
export const HOST_RUNTIME_FILES=Object.freeze([
  'bin/bridge-host-daemon.mjs',
  'src/host-files.mjs','src/host-platform.mjs','src/host-runner.mjs','src/host-runtime-status.mjs',
  'src/direct-connect-client.mjs','src/direct-runner-client.mjs','src/direct-exec.mjs',
  'src/direct-runner-assets.mjs','src/direct-runner-exports.mjs','src/direct-runner-journal.mjs','src/doctor.mjs',
  'src/validate.mjs','src/task-runtime-binding.mjs','src/environment.mjs',
  'src/execute.mjs','src/json.mjs','src/errors.mjs','src/host-http.mjs'
]);
export const HOST_PACKAGE_FILES=Object.freeze([
  ...HOST_RUNTIME_FILES,'LICENSE','bin/bridge-host.mjs','src/host-package-spec.mjs',
  'src/host-maintenance.mjs','src/host-native-service.mjs','src/host-windows-action.mjs','src/host-persistence.mjs',
  'src/host-loopback.mjs','src/host-login.mjs','src/host-service.mjs','src/host-onboarding.mjs'
]);
