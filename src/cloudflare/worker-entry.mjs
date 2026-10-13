import {
  AuthorizationError,
  OAuthProvider
} from '@cloudflare/workers-oauth-provider';
import { createCloudflareBridgeOAuthProvider } from './oauth-provider-app.mjs';

let application=null;
let signature=null;

function deploymentSignature(env) {
  return [
    env.BRIDGE_PUBLIC_URL,
    env.BRIDGE_GITHUB_APP_ISSUER,
    env.BRIDGE_GITHUB_APP_CLIENT_ID,
    env.BRIDGE_GITHUB_APP_SLUG,
    env.BRIDGE_GITHUB_CALLBACK_URL ?? '',
    env.BRIDGE_TASK_LAUNCHER_URL ?? '',
    env.BRIDGE_DIRECT_ADMIN_TOKEN ?? ''
  ].join('|');
}

function applicationFor(env) {
  const nextSignature=deploymentSignature(env);
  if(application===null || signature!==nextSignature) {
    application=createCloudflareBridgeOAuthProvider({
      env,
      OAuthProviderClass:OAuthProvider,
      AuthorizationErrorClass:AuthorizationError
    });
    signature=nextSignature;
  }
  return application;
}

export default {
  async fetch(request,env,ctx) {
    return applicationFor(env).fetch(request,ctx);
  },
  async scheduled(_controller,env,ctx) {
    const work=applicationFor(env).scheduled();
    if(ctx && typeof ctx.waitUntil==='function') {
      ctx.waitUntil(work);
      return;
    }
    await work;
  }
};
