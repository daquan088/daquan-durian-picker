export interface Env {
  MODEL_ID: string
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api')) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
