import { createServerFn } from "@tanstack/react-start";
import { fetchLibrary } from "@/server/fns/library";

export const getLibrary = createServerFn({ method: "GET" }).handler(() => fetchLibrary());
