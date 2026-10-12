import { readFileSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';
import type { AuthConfig } from '../config.js';

export type TokenProvider = (environmentUrl: string) => Promise<string>;

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Delegated-auth token provider via Azure CLI — no app registration needed.
 * The signed-in user (e.g. a Power Platform admin who self-elevated to System
 * Administrator in the target environments) runs `az login` once; the tool then
 * requests a Dataverse token per environment. Tokens are cached until ~5 min
 * before expiry.
 */
export function createAzCliTokenProvider(): TokenProvider {
  const cache = new Map<string, { token: string; expiresAt: number }>();

  return async (environmentUrl: string): Promise<string> => {
    const resource = environmentUrl.replace(/\/+$/, '');
    const key = resource.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;

    if (!/^https:\/\/[a-z0-9.-]+$/i.test(resource)) {
      throw new Error(`Refusing to request a token for suspicious resource URL: ${resource}`);
    }
    let stdout: string;
    try {
      // On Windows az is az.cmd, which Node only runs via a shell; pass one
      // pre-composed string (resource is validated above) to avoid arg-concat issues.
      if (process.platform === 'win32') {
        ({ stdout } = await execAsync(
          `az account get-access-token --resource "${resource}" --output json`,
          { windowsHide: true }
        ));
      } else {
        ({ stdout } = await execFileAsync(
          'az',
          ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
          { windowsHide: true }
        ));
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Azure CLI token request failed for ${resource}. Is Azure CLI installed and are you signed in (az login)? ` +
          `Original error: ${detail.slice(0, 300)}`
      );
    }
    const parsed = JSON.parse(stdout) as {
      accessToken: string;
      expiresOn?: string;
      expires_on?: number | string;
    };
    if (!parsed.accessToken) throw new Error(`Azure CLI returned no accessToken for ${resource}.`);

    let expiresAt = Date.now() + 45 * 60_000;
    if (parsed.expires_on !== undefined && Number.isFinite(Number(parsed.expires_on))) {
      expiresAt = Number(parsed.expires_on) * 1000;
    } else if (parsed.expiresOn) {
      const ts = Date.parse(parsed.expiresOn);
      if (!Number.isNaN(ts)) expiresAt = ts;
    }
    cache.set(key, { token: parsed.accessToken, expiresAt });
    return parsed.accessToken;
  };
}

/** Client-credentials token provider for Dataverse (secret or certificate). */
export function createTokenProvider(auth: AuthConfig): TokenProvider {
  const clientAuth: Configuration['auth'] = {
    clientId: auth.clientId,
    authority: `https://login.microsoftonline.com/${auth.tenantId}`,
  };
  if (auth.clientSecret) {
    clientAuth.clientSecret = auth.clientSecret;
  } else if (auth.certPemPath && auth.certThumbprint) {
    clientAuth.clientCertificate = {
      thumbprint: auth.certThumbprint,
      privateKey: readFileSync(auth.certPemPath, 'utf8'),
    };
  } else {
    throw new Error('No client secret or certificate configured.');
  }

  const cca = new ConfidentialClientApplication({ auth: clientAuth });

  return async (environmentUrl: string): Promise<string> => {
    const scope = `${environmentUrl.replace(/\/+$/, '')}/.default`;
    const result = await cca.acquireTokenByClientCredential({ scopes: [scope] });
    if (!result?.accessToken) {
      throw new Error(`Token acquisition returned no access token for ${environmentUrl}`);
    }
    return result.accessToken;
  };
}
