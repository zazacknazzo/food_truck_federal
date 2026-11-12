declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    FEDERAL_OPERATORS?: string;
  }
}
