// packages/engine/src/credentials.ts
import { fromIni, fromTemporaryCredentials, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { CredConfig } from "@chaos/shared";

export function resolveCredentials(creds: CredConfig, region: string): AwsCredentialIdentityProvider {
  switch (creds.mode) {
    case "profile": return fromIni({ profile: creds.profile });
    case "default": return fromNodeProviderChain();
    case "assumeRole":
      return fromTemporaryCredentials({
        params: { RoleArn: creds.roleArn!, RoleSessionName: "chaos-console",
          ...(creds.externalId ? { ExternalId: creds.externalId } : {}) },
        clientConfig: { region },
      });
  }
}
