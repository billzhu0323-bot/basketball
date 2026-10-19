import pg from "pg";
import { env } from "../config/env.js";

// Connects as `app_user` (RLS enforced). Never point this at the owner role.
export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
