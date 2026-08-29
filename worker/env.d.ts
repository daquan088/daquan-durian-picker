export interface Env {
  MODEL_ID: string
  ASSETS: Fetcher
  QUOTA: KVNamespace
  OPENAI_API_KEY: string
  QUOTA_SALT: string
  TASK_TOKEN_SECRET: string
}
