/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module "file-icons-js" {
  export function getClass(name: string): string | null;
  export function getClassWithColor(name: string): string | null;
}
