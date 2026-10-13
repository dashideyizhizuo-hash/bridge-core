export async function createBridgeRemoteRuntime({ resourceServerUrl }) {
  return {
    oauth: {
      verifier: {
        async verifyAccessToken() {
          throw new Error('fixture verifier should not be called');
        }
      },
      principalResolver: {
        async resolve() {
          return null;
        }
      },
      metadata: {
        issuer: 'https://identity.example/',
        authorization_endpoint: 'https://identity.example/authorize',
        token_endpoint: 'https://identity.example/oauth/token',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['bridge']
      },
      requiredScopes: ['bridge']
    },
    identity: {
      principalRepositoryAuthorizer: {
        async assert() {
          throw new Error('fixture authorizer should not be called');
        }
      },
      installationResolver: {
        async resolve() {
          throw new Error('fixture installation resolver should not be called');
        }
      }
    },
    fixtureResource: resourceServerUrl.href
  };
}
