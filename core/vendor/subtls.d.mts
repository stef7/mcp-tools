/** Types for the parts of core/vendor/subtls.mjs that core/proxy.ts uses. */

export type RootCertsDatabase = { index: unknown; data: Uint8Array };

export class TrustedCert {
  /** Trusted certificates, as PEM. Only their names, keys, dates and CA flags are used. */
  static databaseFromPEM(pem: string): Promise<RootCertsDatabase>;
}

/**
 * TLS 1.3 over whatever `networkRead` and `networkWrite` carry. Throws if the server's
 * certificate does not name `host` or does not lead to one in `rootCertsDatabase`.
 * `read` gives the next decrypted record, or undefined once the server has closed.
 */
export function startTls(
  host: string,
  rootCertsDatabase: RootCertsDatabase | string,
  /** `readMode` 1 is PEEK: return the bytes but leave them to be read again. */
  networkRead: (bytes: number, readMode?: number) => Promise<Uint8Array | undefined>,
  networkWrite: (data: Uint8Array) => void,
  options?: { useSNI?: boolean; protocolsForALPN?: string[] },
): Promise<{
  read: () => Promise<Uint8Array | undefined>;
  write: (data: Uint8Array) => Promise<void>;
  end: () => Promise<void>;
}>;
