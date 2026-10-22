import { assertEquals } from "@std/assert";
import { builtinInstanceId, builtinInstanceName } from "../src/core/ids.ts";

Deno.test("a builtin instance id round-trips its name", () => {
  const id = builtinInstanceId("users", "map", "0123456789ab");
  assertEquals(id, "value:users#$builtin/map/0123456789ab");
  assertEquals(builtinInstanceName(id), "map");
});

Deno.test("builtinInstanceName rejects other identities", () => {
  assertEquals(builtinInstanceName("value:m#map"), undefined);
  assertEquals(builtinInstanceName("type:m#$builtin/x/1"), undefined);
  assertEquals(builtinInstanceName("local:m#f/x"), undefined);
});
