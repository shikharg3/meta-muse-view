import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

const queryClient = postgres(env().DATABASE_URL, { max: 5 });
export const db = drizzle({ client: queryClient, schema });
export { schema };
