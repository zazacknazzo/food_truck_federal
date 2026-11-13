declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    FEDERAL_OPERATORS?: string;
    FEDERAL_MODE?: string;
    FEDERAL_PUBLIC_ORIGIN?: string;
    FEDERAL_PRODUCTION_APPROVAL?: string;
    FEDERAL_RECONCILIATION_SECRET?: string;
    FEDERAL_MP_TEST_ACCESS_TOKEN?: string;
    FEDERAL_MP_TEST_WEBHOOK_SECRET?: string;
    FEDERAL_MP_TEST_COLLECTOR_ID?: string;
    FEDERAL_MP_PROD_ACCESS_TOKEN?: string;
    FEDERAL_MP_PROD_WEBHOOK_SECRET?: string;
    FEDERAL_MP_PROD_COLLECTOR_ID?: string;
  }
}
