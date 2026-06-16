import { createServerFn } from "@tanstack/react-start";
import { fetchTargeting } from "@/server/fns/targeting";

export const getTargeting = createServerFn({ method: "GET" }).handler(() => fetchTargeting());
