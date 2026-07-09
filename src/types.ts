export interface DomainEntry {
  name: string;
  targetPort: number;
}

export interface CloudflareConfig {
  apiToken: string;
  email: string | null;
}

export interface Config {
  port: number | null;
  domains: DomainEntry[];
  baseDomain: string | null;
  cloudflare: CloudflareConfig | null;
  tunnel: boolean;
}

export interface SslOptions {
  certFile: string;
  keyFile: string;
  redirectPort?: number;
  baseDomain?: string;
  caCertPath?: string;
}
