import { onRequestPost as __api_login_ts_onRequestPost } from "/Users/paco/Desktop/PACO/Web_personal/functions/api/login.ts"
import { onRequestPost as __api_logout_ts_onRequestPost } from "/Users/paco/Desktop/PACO/Web_personal/functions/api/logout.ts"
import { onRequestGet as __api_me_ts_onRequestGet } from "/Users/paco/Desktop/PACO/Web_personal/functions/api/me.ts"
import { onRequest as ___middleware_ts_onRequest } from "/Users/paco/Desktop/PACO/Web_personal/functions/_middleware.ts"

export const routes = [
    {
      routePath: "/api/login",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_login_ts_onRequestPost],
    },
  {
      routePath: "/api/logout",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_logout_ts_onRequestPost],
    },
  {
      routePath: "/api/me",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_me_ts_onRequestGet],
    },
  {
      routePath: "/",
      mountPath: "/",
      method: "",
      middlewares: [___middleware_ts_onRequest],
      modules: [],
    },
  ]