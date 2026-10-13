import { assertBridge } from '../errors.mjs';

const STATE_PATTERN=/^[A-Za-z0-9_-]{32,256}$/;

function assertDb(value) {
  assertBridge(
    value && typeof value.prepare==='function' && typeof value.batch==='function',
    'OAUTH_AUTHORIZATION_CONFIG_INVALID',
    'D1 database binding is required for OAuth authorization state'
  );
  return value;
}

function stateValue(value) {
  assertBridge(
    typeof value==='string' && STATE_PATTERN.test(value),
    'OAUTH_AUTHORIZATION_INVALID',
    'OAuth authorization state is invalid'
  );
  return value;
}

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'OAUTH_AUTHORIZATION_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function boundedString(value,label,maximum) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=maximum,
    'OAUTH_AUTHORIZATION_INVALID',
    `${label} is invalid`
  );
  return value;
}

function assertAuthRequest(value) {
  assertBridge(
    value &&
      typeof value==='object' &&
      !Array.isArray(value) &&
      typeof value.responseType==='string' &&
      typeof value.clientId==='string' &&
      typeof value.redirectUri==='string' &&
      Array.isArray(value.scope) &&
      typeof value.state==='string',
    'OAUTH_AUTHORIZATION_INVALID',
    'stored MCP authorization request is invalid'
  );
  return value;
}

function serializeAuthRequest(value) {
  const request=assertAuthRequest(value);
  const text=JSON.stringify(request);
  assertBridge(
    text.length>=2 && text.length<=32_768,
    'OAUTH_AUTHORIZATION_INVALID',
    'MCP authorization request exceeds storage bound'
  );
  return text;
}

function parseAuthRequest(value) {
  boundedString(value,'stored MCP authorization request',32_768);
  let parsed;
  try { parsed=JSON.parse(value); }
  catch {
    assertBridge(
      false,
      'OAUTH_AUTHORIZATION_INVALID',
      'stored MCP authorization request is invalid JSON'
    );
  }
  return assertAuthRequest(parsed);
}

function firstRow(result) {
  return Array.isArray(result?.results) && result.results.length>0
    ? result.results[0]
    : null;
}

function rowRecord(row) {
  if(!row) return null;
  return Object.freeze({
    state:stateValue(row.state),
    oauthRequest:parseAuthRequest(row.oauth_request_json),
    clientName:boundedString(row.client_name,'stored OAuth client name',512),
    codeVerifier:boundedString(row.code_verifier,'stored GitHub PKCE verifier',128),
    codeChallenge:boundedString(row.code_challenge,'stored GitHub PKCE challenge',128),
    installationId:row.installation_id===null || row.installation_id===undefined
      ? null
      : installationId(Number(row.installation_id)),
    consented:Number(row.consented)===1,
    createdAt:Number(row.created_at),
    expiresAt:Number(row.expires_at)
  });
}

export class D1McpAuthorizationStore {
  constructor({db,clock=()=>Date.now()}={}) {
    this.db=assertDb(db);
    assertBridge(
      typeof clock==='function',
      'OAUTH_AUTHORIZATION_CONFIG_INVALID',
      'clock is required'
    );
    this.clock=clock;
  }

  async put({
    state,
    oauthRequest,
    clientName,
    codeVerifier,
    codeChallenge,
    createdAt=this.clock(),
    expiresAt
  }={}) {
    const stateId=stateValue(state);
    const requestJson=serializeAuthRequest(oauthRequest);
    const name=boundedString(clientName,'OAuth client name',512);
    const verifier=boundedString(codeVerifier,'GitHub PKCE verifier',128);
    const challenge=boundedString(codeChallenge,'GitHub PKCE challenge',128);
    assertBridge(
      Number.isSafeInteger(createdAt) &&
        Number.isSafeInteger(expiresAt) &&
        expiresAt>createdAt,
      'OAUTH_AUTHORIZATION_INVALID',
      'OAuth authorization expiry is invalid'
    );

    await this.db.prepare(
      `INSERT INTO mcp_authorization_states (
        state,
        oauth_request_json,
        client_name,
        code_verifier,
        code_challenge,
        installation_id,
        consented,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`
    ).bind(
      stateId,
      requestJson,
      name,
      verifier,
      challenge,
      createdAt,
      expiresAt
    ).run();
  }

  async bindInstallation({
    state,
    installationId:value,
    now=this.clock()
  }={}) {
    const stateId=stateValue(state);
    const id=installationId(value);
    assertBridge(
      Number.isSafeInteger(now),
      'OAUTH_AUTHORIZATION_INVALID',
      'now is invalid'
    );

    const results=await this.db.batch([
      this.db.prepare(
        `UPDATE mcp_authorization_states
         SET installation_id = ?, consented = 1
         WHERE state = ?
           AND installation_id IS NULL
           AND expires_at > ?`
      ).bind(id,stateId,now),
      this.db.prepare(
        `SELECT state, oauth_request_json, client_name,
                code_verifier, code_challenge, installation_id,
                consented, created_at, expires_at
         FROM mcp_authorization_states
         WHERE state = ?
           AND installation_id = ?
           AND consented = 1
           AND expires_at > ?
         LIMIT 1`
      ).bind(stateId,id,now)
    ]);

    const changed=Number(results?.[0]?.meta?.changes ?? 0);
    if(changed!==1) return null;
    return rowRecord(firstRow(results?.[1]));
  }

  async take({state,now=this.clock()}={}) {
    const stateId=stateValue(state);
    assertBridge(
      Number.isSafeInteger(now),
      'OAUTH_AUTHORIZATION_INVALID',
      'now is invalid'
    );

    const results=await this.db.batch([
      this.db.prepare(
        `SELECT state, oauth_request_json, client_name,
                code_verifier, code_challenge, installation_id,
                consented, created_at, expires_at
         FROM mcp_authorization_states
         WHERE state = ? AND expires_at > ?
         LIMIT 1`
      ).bind(stateId,now),
      this.db.prepare(
        `DELETE FROM mcp_authorization_states
         WHERE state = ? AND expires_at > ?`
      ).bind(stateId,now)
    ]);

    const row=firstRow(results?.[0]);
    const changed=Number(results?.[1]?.meta?.changes ?? 0);
    if(!row || changed!==1) return null;
    return rowRecord(row);
  }

  async pruneExpired({limit=100}={}) {
    assertBridge(
      Number.isInteger(limit) && limit>=1 && limit<=500,
      'OAUTH_AUTHORIZATION_INVALID',
      'prune limit invalid'
    );
    const now=this.clock();
    const result=await this.db.prepare(
      `DELETE FROM mcp_authorization_states
       WHERE state IN (
         SELECT state
         FROM mcp_authorization_states
         WHERE expires_at<=?
         ORDER BY expires_at ASC
         LIMIT ?
       )
       RETURNING state`
    ).bind(now,limit).all();
    return {
      removed:Array.isArray(result?.results) ? result.results.length : 0
    };
  }

}
