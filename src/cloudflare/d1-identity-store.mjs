import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';

const PERMISSIONS=new Set(['read','run','publish']);
const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STATE_PATTERN=/^[A-Za-z0-9_-]{32,256}$/;

function assertDb(value) {
  assertBridge(
    value && typeof value.prepare==='function' && typeof value.batch==='function',
    'D1_IDENTITY_CONFIG_INVALID',
    'D1 database binding is required'
  );
  return value;
}

function repositoryName(value) {
  assertBridge(
    typeof value==='string' && REPOSITORY_PATTERN.test(value),
    'D1_IDENTITY_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function permissionName(value) {
  assertBridge(
    PERMISSIONS.has(value),
    'D1_IDENTITY_INVALID',
    `unknown repository permission: ${value}`
  );
  return value;
}

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'D1_IDENTITY_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function booleanInt(value,label) {
  assertBridge(typeof value==='boolean','D1_IDENTITY_INVALID',`${label} must be boolean`);
  return value ? 1 : 0;
}

function stateValue(value) {
  assertBridge(
    typeof value==='string' && STATE_PATTERN.test(value),
    'D1_IDENTITY_INVALID',
    'onboarding state is invalid'
  );
  return value;
}

function resultRow(result) {
  return Array.isArray(result?.results) && result.results.length>0
    ? result.results[0]
    : null;
}

function parsePrincipalJson(value) {
  assertBridge(
    typeof value==='string' && value.length>0 && value.length<=4096,
    'D1_IDENTITY_INVALID',
    'stored onboarding principal is invalid'
  );
  let parsed;
  try { parsed=JSON.parse(value); }
  catch {
    assertBridge(false,'D1_IDENTITY_INVALID','stored onboarding principal is invalid JSON');
  }
  return assertAuthenticatedPrincipal(parsed);
}

function normalizeRepositories(values) {
  assertBridge(
    Array.isArray(values) && values.length<=1000,
    'D1_IDENTITY_INVALID',
    'repositories must be an array with at most 1000 entries'
  );
  const seen=new Set();
  const result=[];
  for(const value of values) {
    const repo=repositoryName(value);
    if(seen.has(repo)) continue;
    seen.add(repo);
    result.push(repo);
  }
  return result;
}

function normalizeInstallation(value) {
  assertBridge(
    value &&
      typeof value==='object' &&
      !Array.isArray(value) &&
      typeof value.accountLogin==='string' &&
      value.accountLogin.length>=1 &&
      value.accountLogin.length<=256 &&
      typeof value.accountId==='string' &&
      value.accountId.length>=1 &&
      value.accountId.length<=128 &&
      typeof value.ownerType==='string' &&
      value.ownerType.length>=1 &&
      value.ownerType.length<=64 &&
      (value.suspendedAt===null || typeof value.suspendedAt==='string'),
    'D1_IDENTITY_INVALID',
    'GitHub installation record is invalid'
  );
  return {
    installationId:installationId(value.installationId),
    accountLogin:value.accountLogin,
    accountId:value.accountId,
    ownerType:value.ownerType,
    suspendedAt:value.suspendedAt
  };
}

function insertRepositoryGrantStatement(db,rows) {
  const placeholders=rows.map(()=>'(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
  const values=[];
  for(const row of rows) {
    values.push(
      row.bridgeUserId,
      row.installationId,
      row.repository,
      row.read,
      row.run,
      row.publish,
      row.now,
      row.now
    );
  }
  return db.prepare(
    `INSERT INTO repository_grants (
      bridge_user_id,
      installation_id,
      repository_full_name,
      can_read,
      can_run,
      can_publish,
      created_at,
      updated_at
    ) VALUES ${placeholders}`
  ).bind(...values);
}

export class D1BridgeIdentityStore {
  constructor({
    db,
    clock=()=>Date.now(),
    randomUUID=()=>globalThis.crypto.randomUUID()
  }={}) {
    this.db=assertDb(db);
    assertBridge(typeof clock==='function','D1_IDENTITY_CONFIG_INVALID','clock is required');
    assertBridge(typeof randomUUID==='function','D1_IDENTITY_CONFIG_INVALID','randomUUID is required');
    this.clock=clock;
    this.randomUUID=randomUUID;
  }

  async put(record) {
    const principal=assertAuthenticatedPrincipal(record?.principal);
    const state=stateValue(record?.state);
    assertBridge(
      typeof record?.codeVerifier==='string' &&
        record.codeVerifier.length>=43 &&
        record.codeVerifier.length<=128 &&
        typeof record?.codeChallenge==='string' &&
        record.codeChallenge.length>=43 &&
        record.codeChallenge.length<=128 &&
        Number.isSafeInteger(record?.createdAt) &&
        Number.isSafeInteger(record?.expiresAt) &&
        record.expiresAt>record.createdAt,
      'D1_IDENTITY_INVALID',
      'onboarding state record is invalid'
    );
    await this.db.prepare(
      `INSERT INTO github_onboarding_states (
        state,
        bridge_user_id,
        principal_json,
        code_verifier,
        code_challenge,
        installation_id,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    ).bind(
      state,
      principal.bridgeUserId,
      JSON.stringify(principal),
      record.codeVerifier,
      record.codeChallenge,
      record.createdAt,
      record.expiresAt
    ).run();
  }

  async bindInstallation({state,installationId:value,now=this.clock()}={}) {
    const stateId=stateValue(state);
    const id=installationId(value);
    assertBridge(Number.isSafeInteger(now),'D1_IDENTITY_INVALID','now is invalid');
    const results=await this.db.batch([
      this.db.prepare(
        `UPDATE github_onboarding_states
         SET installation_id = ?
         WHERE state = ?
           AND installation_id IS NULL
           AND expires_at > ?`
      ).bind(id,stateId,now),
      this.db.prepare(
        `SELECT state, principal_json, code_verifier, code_challenge,
                installation_id, created_at, expires_at
         FROM github_onboarding_states
         WHERE state = ? AND installation_id = ? AND expires_at > ?
         LIMIT 1`
      ).bind(stateId,id,now)
    ]);
    const row=resultRow(results?.[1]);
    if(!row) return null;
    return {
      state:row.state,
      principal:parsePrincipalJson(row.principal_json),
      codeVerifier:row.code_verifier,
      codeChallenge:row.code_challenge,
      installationId:Number(row.installation_id),
      createdAt:Number(row.created_at),
      expiresAt:Number(row.expires_at)
    };
  }

  async take({state,now=this.clock()}={}) {
    const stateId=stateValue(state);
    assertBridge(Number.isSafeInteger(now),'D1_IDENTITY_INVALID','now is invalid');
    const results=await this.db.batch([
      this.db.prepare(
        `SELECT state, principal_json, code_verifier, code_challenge,
                installation_id, created_at, expires_at
         FROM github_onboarding_states
         WHERE state = ? AND expires_at > ?
         LIMIT 1`
      ).bind(stateId,now),
      this.db.prepare(
        'DELETE FROM github_onboarding_states WHERE state = ?'
      ).bind(stateId)
    ]);
    const row=resultRow(results?.[0]);
    if(!row) return null;
    return {
      state:row.state,
      principal:parsePrincipalJson(row.principal_json),
      codeVerifier:row.code_verifier,
      codeChallenge:row.code_challenge,
      installationId:row.installation_id===null ? undefined : Number(row.installation_id),
      createdAt:Number(row.created_at),
      expiresAt:Number(row.expires_at)
    };
  }

  async commitGitHubOnboarding({
    principal,
    githubUser,
    installation,
    repositories,
    permissions
  }={}) {
    const authenticatedPrincipal=assertAuthenticatedPrincipal(principal);
    assertBridge(
      githubUser &&
        typeof githubUser.id==='string' &&
        githubUser.id.length>=1 &&
        githubUser.id.length<=128 &&
        typeof githubUser.login==='string' &&
        githubUser.login.length>=1 &&
        githubUser.login.length<=256,
      'D1_IDENTITY_INVALID',
      'GitHub user identity is invalid'
    );
    if(authenticatedPrincipal.githubUserId!==undefined) {
      assertBridge(
        authenticatedPrincipal.githubUserId===githubUser.id,
        'D1_IDENTITY_DENIED',
        'GitHub identity does not match Bridge principal'
      );
    }
    const normalizedInstallation=normalizeInstallation(installation);
    const repos=normalizeRepositories(repositories);
    const read=booleanInt(permissions?.read,'read permission');
    const run=booleanInt(permissions?.run,'run permission');
    const publish=booleanInt(permissions?.publish,'publish permission');
    assertBridge(
      run<=read && publish<=run,
      'D1_IDENTITY_INVALID',
      'repository grant hierarchy is invalid'
    );

    const existing=await this.db.prepare(
      `SELECT external_provider, external_subject, github_user_id
       FROM bridge_users
       WHERE id = ?
       LIMIT 1`
    ).bind(authenticatedPrincipal.bridgeUserId).first();
    if(existing) {
      assertBridge(
        existing.external_provider===authenticatedPrincipal.externalProvider &&
          existing.external_subject===authenticatedPrincipal.externalSubject &&
          (
            existing.github_user_id===null ||
            existing.github_user_id===undefined ||
            String(existing.github_user_id)===githubUser.id
          ),
        'D1_IDENTITY_DENIED',
        'stored Bridge principal identity does not match onboarding principal'
      );
    }

    const now=this.clock();
    const statements=[
      this.db.prepare(
        `INSERT INTO bridge_users (
          id,
          external_provider,
          external_subject,
          github_user_id,
          github_login,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          github_user_id = excluded.github_user_id,
          github_login = excluded.github_login,
          updated_at = excluded.updated_at`
      ).bind(
        authenticatedPrincipal.bridgeUserId,
        authenticatedPrincipal.externalProvider,
        authenticatedPrincipal.externalSubject,
        githubUser.id,
        githubUser.login,
        now,
        now
      ),
      this.db.prepare(
        `INSERT INTO github_installations (
          installation_id,
          account_login,
          account_id,
          owner_type,
          suspended_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          account_login = excluded.account_login,
          account_id = excluded.account_id,
          owner_type = excluded.owner_type,
          suspended_at = excluded.suspended_at,
          updated_at = excluded.updated_at`
      ).bind(
        normalizedInstallation.installationId,
        normalizedInstallation.accountLogin,
        normalizedInstallation.accountId,
        normalizedInstallation.ownerType,
        normalizedInstallation.suspendedAt,
        now,
        now
      ),
      this.db.prepare(
        `INSERT INTO user_installation_grants (
          bridge_user_id,
          installation_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(bridge_user_id, installation_id) DO UPDATE SET
          updated_at = excluded.updated_at`
      ).bind(
        authenticatedPrincipal.bridgeUserId,
        normalizedInstallation.installationId,
        now,
        now
      ),
      this.db.prepare(
        `DELETE FROM repository_grants
         WHERE bridge_user_id = ? AND installation_id = ?`
      ).bind(
        authenticatedPrincipal.bridgeUserId,
        normalizedInstallation.installationId
      )
    ];

    const rows=repos.map(repository=>({
      bridgeUserId:authenticatedPrincipal.bridgeUserId,
      installationId:normalizedInstallation.installationId,
      repository,
      read,
      run,
      publish,
      now
    }));
    for(let index=0;index<rows.length;index+=100) {
      statements.push(insertRepositoryGrantStatement(this.db,rows.slice(index,index+100)));
    }

    await this.db.batch(statements);
  }

  async assert({principal,repository,permission}={}) {
    const authenticatedPrincipal=assertAuthenticatedPrincipal(principal);
    const repo=repositoryName(repository);
    const requested=permissionName(permission);
    const row=await this.db.prepare(
      `SELECT rg.can_read, rg.can_run, rg.can_publish, gi.suspended_at
       FROM repository_grants rg
       JOIN user_installation_grants uig
         ON uig.bridge_user_id = rg.bridge_user_id
        AND uig.installation_id = rg.installation_id
       JOIN github_installations gi
         ON gi.installation_id = rg.installation_id
       WHERE rg.bridge_user_id = ?
         AND rg.repository_full_name = ?
       ORDER BY rg.installation_id ASC
       LIMIT 1`
    ).bind(authenticatedPrincipal.bridgeUserId,repo).first();

    const field={
      read:'can_read',
      run:'can_run',
      publish:'can_publish'
    }[requested];
    assertBridge(
      row &&
        (row.suspended_at===null || row.suspended_at===undefined) &&
        Number(row[field])===1,
      'REPOSITORY_DENIED',
      `${requested} access denied for repository: ${repo}`
    );
    return repo;
  }

  async resolve({principal,repository}={}) {
    const authenticatedPrincipal=assertAuthenticatedPrincipal(principal);
    const repo=repositoryName(repository);
    const row=await this.db.prepare(
      `SELECT rg.installation_id
       FROM repository_grants rg
       JOIN user_installation_grants uig
         ON uig.bridge_user_id = rg.bridge_user_id
        AND uig.installation_id = rg.installation_id
       JOIN github_installations gi
         ON gi.installation_id = rg.installation_id
       WHERE rg.bridge_user_id = ?
         AND rg.repository_full_name = ?
         AND gi.suspended_at IS NULL
       ORDER BY rg.installation_id ASC
       LIMIT 1`
    ).bind(authenticatedPrincipal.bridgeUserId,repo).first();

    assertBridge(
      row && Number.isSafeInteger(Number(row.installation_id)) && Number(row.installation_id)>0,
      'GITHUB_APP_AUTHORIZATION_DENIED',
      'principal repository installation is unavailable'
    );
    return {installationId:Number(row.installation_id)};
  }

  async ensurePrincipal({externalProvider,externalSubject}={}) {
    assertBridge(
      typeof externalProvider==='string' &&
        externalProvider.length>=1 &&
        externalProvider.length<=256 &&
        typeof externalSubject==='string' &&
        externalSubject.length>=1 &&
        externalSubject.length<=256,
      'D1_IDENTITY_INVALID',
      'external identity is invalid'
    );

    const existing=await this.resolvePrincipal({externalProvider,externalSubject});
    if(existing) return existing;

    const bridgeUserId=`bridge-user-${this.randomUUID()}`;
    const now=this.clock();
    await this.db.prepare(
      `INSERT INTO bridge_users (
        id,
        external_provider,
        external_subject,
        github_user_id,
        github_login,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(external_provider, external_subject) DO NOTHING`
    ).bind(
      bridgeUserId,
      externalProvider,
      externalSubject,
      now,
      now
    ).run();

    const created=await this.resolvePrincipal({externalProvider,externalSubject});
    assertBridge(
      created,
      'D1_IDENTITY_INVALID',
      'unable to persist authenticated Bridge principal'
    );
    return created;
  }

  async resolvePrincipalByGitHubUserId(githubUserId) {
    assertBridge(
      typeof githubUserId==='string' &&
        githubUserId.length>=1 &&
        githubUserId.length<=128 &&
        /^[0-9]+$/.test(githubUserId),
      'D1_IDENTITY_INVALID',
      'githubUserId is invalid'
    );
    const row=await this.db.prepare(
      `SELECT id, external_provider, external_subject, github_user_id
       FROM bridge_users
       WHERE github_user_id = ?
       LIMIT 2`
    ).bind(githubUserId).all();
    const rows=Array.isArray(row?.results) ? row.results : [];
    assertBridge(
      rows.length<=1,
      'D1_IDENTITY_DENIED',
      'GitHub user identity maps to multiple Bridge principals'
    );
    if(rows.length===0) return null;
    const value=rows[0];
    return assertAuthenticatedPrincipal({
      bridgeUserId:value.id,
      externalProvider:value.external_provider,
      externalSubject:value.external_subject,
      githubUserId:String(value.github_user_id)
    });
  }

  async resolvePrincipalById(bridgeUserId) {
    assertBridge(
      typeof bridgeUserId==='string' &&
        bridgeUserId.length>=1 &&
        bridgeUserId.length<=256,
      'D1_IDENTITY_INVALID',
      'bridgeUserId is invalid'
    );
    const row=await this.db.prepare(
      `SELECT id, external_provider, external_subject, github_user_id
       FROM bridge_users
       WHERE id = ?
       LIMIT 1`
    ).bind(bridgeUserId).first();
    if(!row) return null;
    return assertAuthenticatedPrincipal({
      bridgeUserId:row.id,
      externalProvider:row.external_provider,
      externalSubject:row.external_subject,
      ...(row.github_user_id===null || row.github_user_id===undefined
        ? {}
        : {githubUserId:String(row.github_user_id)})
    });
  }

  async resolvePrincipal({externalProvider,externalSubject}={}) {
    assertBridge(
      typeof externalProvider==='string' &&
        externalProvider.length>=1 &&
        externalProvider.length<=256 &&
        typeof externalSubject==='string' &&
        externalSubject.length>=1 &&
        externalSubject.length<=256,
      'D1_IDENTITY_INVALID',
      'external identity is invalid'
    );
    const row=await this.db.prepare(
      `SELECT id, external_provider, external_subject, github_user_id
       FROM bridge_users
       WHERE external_provider = ? AND external_subject = ?
       LIMIT 1`
    ).bind(externalProvider,externalSubject).first();
    if(!row) return null;
    return assertAuthenticatedPrincipal({
      bridgeUserId:row.id,
      externalProvider:row.external_provider,
      externalSubject:row.external_subject,
      ...(row.github_user_id===null || row.github_user_id===undefined
        ? {}
        : {githubUserId:String(row.github_user_id)})
    });
  }
}
