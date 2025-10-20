import { Env, cookieHeader } from '../_utils/auth';


export const onRequestPost: PagesFunction<Env> = async ({ env }) => {
return new Response(JSON.stringify({ ok: true }), {
headers: {
'content-type': 'application/json',
'set-cookie': cookieHeader(env, null),
},
});
};