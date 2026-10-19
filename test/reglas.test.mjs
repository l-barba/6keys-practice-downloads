import assert from "node:assert/strict";
import test from "node:test";
import {
  comprobarFicheros, comprobarYml, leerYml, compararVersiones, diasEntre, esViernes, ficherosDeLaVersion, leerAnclaDelTag,
  leerProcedencia, marcaDeProcedencia, noEnViernes, tagDelPaquete, versionEstable
} from "../entrega/reglas.mjs";

const DESTINO = "l-barba/6keys-practice-downloads";

test("versiones: solo X.Y.Z, y se comparan por números", () => {
  assert.deepEqual(versionEstable("0.5.0"), { texto: "0.5.0", partes: [0, 5, 0], tag: "v0.5.0", rama: "release/0.5" });
  for (const mala of ["v0.5.0", "0.5", "0.5.0-rc.1", "05.1.0", "", null]) assert.throws(() => versionEstable(mala));
  assert.ok(compararVersiones("0.10.0", "0.9.9") > 0);
  assert.ok(compararVersiones("v0.4.1", "0.4.2") < 0);
  assert.equal(compararVersiones("v1.2.3", "1.2.3"), 0);
});

test("un ensayo se publica bajo un tag fuera de v*", () => {
  assert.equal(tagDelPaquete({ version: "0.4.1", ensayo: true, runId: 12 }), "ensayo-12");
  assert.equal(tagDelPaquete({ version: "0.4.1", ensayo: false, runId: 12 }), "v0.4.1");
});

test("ficheros: exactamente los de la versión; blockmaps de Mac opcionales", () => {
  const todos = ficherosDeLaVersion("0.5.0");
  comprobarFicheros(todos, "0.5.0");
  comprobarFicheros(todos.filter(n => !/\.(dmg|zip)\.blockmap$/.test(n)), "0.5.0");
  assert.throws(() => comprobarFicheros(todos.filter(n => !n.endsWith(".exe.blockmap")), "0.5.0"), /Faltan/);
  assert.throws(() => comprobarFicheros([...todos, "otro.txt"], "0.5.0"), /ajenos/);
  assert.throws(() => comprobarFicheros([...todos, todos[0]], "0.5.0"), /repetidos/);
  assert.throws(() => comprobarFicheros(ficherosDeLaVersion("0.4.1"), "0.5.0"), /ajenos/);
});

// El formato real de un manifiesto publicado (v0.4.1, 2026-10-01).
const yml041 = `version: 0.4.1
files:
  - url: >-
      https://github.com/${DESTINO}/releases/download/v0.4.1/6Keys-Practice-0.4.1-x64.exe
    sha512: >-
      ve575R0w39r2elKX+dTlZ2uYNOeTM2m5AoS2pO5YWdJWGrDFJhEAkpJxuAcFFHg4KZpk4KGTCpoEFds5WbT6rA==
    size: 226910883
path: >-
  https://github.com/${DESTINO}/releases/download/v0.4.1/6Keys-Practice-0.4.1-x64.exe
sha512: >-
  ve575R0w39r2elKX+dTlZ2uYNOeTM2m5AoS2pO5YWdJWGrDFJhEAkpJxuAcFFHg4KZpk4KGTCpoEFds5WbT6rA==
releaseDate: '2026-10-01T14:36:00.441Z'
`;

const ok041 = { version: "0.4.1", destino: DESTINO, tag: "v0.4.1", nombre: "latest-x64.yml" };

test("yml del actualizador: el formato real se lee y devuelve sus ficheros", () => {
  assert.deepEqual(comprobarYml(yml041, ok041), [{ nombre: "6Keys-Practice-0.4.1-x64.exe", size: 226910883, sha512: "ve575R0w39r2elKX+dTlZ2uYNOeTM2m5AoS2pO5YWdJWGrDFJhEAkpJxuAcFFHg4KZpk4KGTCpoEFds5WbT6rA==" }]);
  assert.equal(leerYml(yml041).releaseDate, "2026-10-01T14:36:00.441Z");
});

test("yml del actualizador: solo su versión, su tag, su arquitectura y nada que no escriba electron-builder", () => {
  const malos = [
    [{ ...ok041, version: "0.4.2", tag: "v0.4.2" }, yml041, /anuncia 0.4.1/],
    [{ ...ok041, tag: "ensayo-1" }, yml041, /fuera de lo permitido/],
    [{ ...ok041, nombre: "latest-arm64-mac.yml" }, yml041, /fuera de lo permitido/],
    [ok041, yml041.replace("v0.4.1/6Keys", "v0.4.1/../6Keys"), /fuera de lo permitido/],
    [ok041, yml041.replace(/https:\/\/github.com/g, "https://evil.example"), /fuera de lo permitido/],
    // Lo que encontró Codex: un destino relativo al protocolo y la URL buena escondida en un comentario.
    [ok041, yml041.replace(/  - url: >-\n.*\n/, "  - url: //evil.example/reemplazo.exe # https://github.com/l-barba/6keys-practice-downloads/releases/download/v0.4.1/6Keys-Practice-0.4.1-x64.exe\n"), /comentarios/],
    [ok041, yml041.replace(/  - url: >-\n.*\n/, "  - url: //evil.example/reemplazo.exe\n"), /fuera de lo permitido/],
    [ok041, yml041.replace("releaseDate", "stagingPercentage: 100\nreleaseDate"), /Clave desconocida/],
    [ok041, yml041.replace("files:", "files:\n\t"), /tabuladores/],
    [ok041, "version: 0.4.1\nfiles:\n  - url: 6Keys-Practice-0.4.1-x64.exe\n    sha512: x\n    size: 1\n", /fuera de lo permitido/],
    [ok041, yml041.replace(/^sha512: >-\n.*$/m, "sha512: >-\n  AAAA"), /«path» y «sha512»/]
  ];
  for (const [opciones, texto, error] of malos) assert.throws(() => comprobarYml(texto, opciones), error);
});

test("viernes en Madrid, no en UTC", () => {
  assert.equal(esViernes(new Date("2026-10-23T12:00:00Z")), true);
  assert.equal(esViernes(new Date("2026-10-22T22:30:00Z")), true, "jueves 22:30 UTC ya es viernes en Madrid");
  assert.equal(esViernes(new Date("2026-10-23T22:30:00Z")), false, "viernes 22:30 UTC ya es sábado en Madrid");
  assert.throws(() => noEnViernes(new Date("2026-10-23T12:00:00Z"), "publicar"), /viernes/);
  assert.match(noEnViernes(new Date("2026-10-23T12:00:00Z"), "publicar", "clínica parada"), /urgencia/);
  assert.equal(noEnViernes(new Date("2026-10-19T12:00:00Z"), "publicar"), undefined);
});

test("días entre fechas", () => {
  assert.equal(diasEntre("2026-10-20", "2026-10-27"), 7);
  assert.equal(diasEntre("2026-10-27", "2026-10-20"), -7);
  assert.throws(() => diasEntre("20/10/2026", "2026-10-27"), /AAAA-MM-DD/);
});

test("marcas en el cuerpo y ancla del tag", () => {
  const p = { sha: "a".repeat(40), run_id: 3 };
  assert.deepEqual(leerProcedencia(`texto\n\n${marcaDeProcedencia(p)}\n`), p);
  assert.equal(leerProcedencia("sin marca"), null);
  const ancla = { run_id: 3, manifiesto_sha256: "b".repeat(64), artefacto_id: 9, artefacto_digest: `sha256:${"c".repeat(64)}` };
  assert.deepEqual(leerAnclaDelTag(`6Keys Practice 0.5.0\n\nsixkeys-candidato: ${JSON.stringify(ancla)}\n`), ancla);
  assert.throws(() => leerAnclaDelTag("6Keys Practice 0.5.0"), /sixkeys-candidato/);
  assert.throws(() => leerAnclaDelTag(`sixkeys-candidato: ${JSON.stringify({ ...ancla, artefacto_digest: "x" })}`), /incompleta/);
});
