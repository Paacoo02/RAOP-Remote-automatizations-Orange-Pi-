import { Env, readSession } from '../_utils/auth';


export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
const session = await readSession(env, request);
if (!session) return new Response(JSON.stringify({ authenticated: false }), { status: 401 });
return new Response(JSON.stringify({ authenticated: true, user: session.sub }), { headers: { 'content-type': 'application/json' } });
};