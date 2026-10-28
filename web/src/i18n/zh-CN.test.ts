import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "./en.ts";
import { zhCN } from "./zh-CN.ts";

/** Every message by its dotted key, with its value. */
function messages(catalog: object, prefix = ""): [string, unknown][] {
  return Object.entries(catalog).flatMap(([key, value]): [string, unknown][] =>
    typeof value === "object" && value !== null ? messages(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );
}

/** Sample values for each message that takes values, by its key: the kinds of value the English one takes. */
const samples: Record<string, unknown[]> = {
  "time.today": ["8:00"],
  "time.tomorrow": ["8:00"],
  "time.yesterday": ["8:00"],
  "time.onDay": ["Fri, Oct 23", "8:00"],
  "schedule.once": ["Fri, Oct 23, 8:00"],
  "schedule.everyDayAt": ["03:00"],
  "schedule.state.next": ["Tomorrow, 8:00"],
  "schedule.lastRun": ["Today, 8:00", "Reported", "Sample summary"],
  "connections.noMatch": ["Sample"],
  "connections.keyIntro": ["Cloudflare"],
  "connections.optionsFor": ["Sample"],
  "keys.keyHint": ["ak_1234"],
  "keys.guide.signIn": ["platform.openai.com"],
  "keys.steps.lands": ["http://127.0.0.1:1455"],
  "keys.codeExpires": ["12:34"],
  "models.modelFor": ["Chat"],
  "models.providerFor": ["Chat"],
  "models.thinkingFor": ["Chat"],
  "models.usedFor": [["chat", "the browser"]],
  "logins.signOutOf": ["example.com"],
  "secrets.noMatch": ["sample"],
  "secrets.removeField": ["key"],
  "secrets.fileNamePlaceholder": ["key.json"],
  "secrets.fileTooBig": [64],
  "secrets.lastUsedSandbox": ["Today, 2:02 PM", "$API_KEY"],
  "secrets.lastUsedServer": ["Today, 2:02 PM", "OpenAI models"],
  "secrets.removeFieldTitle": ["key"],
  "secrets.removeTitle": ["Sample key"],
  "secrets.useFor": ["key"],
  "secrets.env": ["API_KEY"],
  "secrets.atPath": [".config/tool/token"],
  "secrets.atPathWithEnv": [".config/tool/token", "TOOL_TOKEN"],
  "secrets.forModels": ["OpenAI"],
  "secrets.forVoice": ["OpenAI"],
  "secrets.forApps": ["Composio"],
  "permissions.notAddress": ["not a site"],
  "permissions.pair": ["Visit", "Allow"],
  "explainer.dataTitle": ["Sample app"],
  "explainer.dataBody": ["Sample app"],
  "chat.newMessages": [2],
  "chat.messageIn": ["Side chat"],
  "chat.removeFile": ["photo.png"],
  "photos.open": ["beach.jpg"],
  "chat.notSent": ["Sample reason"],
  "viewer.browserWith": ["Working"],
  "cards.setsUp": ["$API_KEY"],
  "cards.destinationPane": ["1"],
  "sidebar.noMatch": ["Sample"],
  "sidebar.optionsFor": ["Sample chat"],
  "sidebar.ago.minutes": [5],
  "sidebar.ago.hours": [3],
  "sidebar.ago.days": [2],
  "goals.doneOn": ["Oct 21"],
  "goals.latestNote": ["Oct 21", "A note"],
  "goals.added": ["Oct 21"],
  "goals.startedOn": ["Oct 21"],
  "goals.sinceDay": ["Oct 21"],
  "skills.removeTitle": ["Sample skill"],
  "skills.installMessage": ["a sample"],
  "viewer.browsersOpen": [2],
  "viewer.closeBrowserAt": ["example.com"],
  "viewer.showBrowserAt": ["example.com"],
  "panel.taskSteps": ["Working", 1, 3],
  "panel.connectTitle": ["Sample app"],
  "pin.wrong": [3],
  "pin.lockedUntil": ["14:30"],
  "pin.lockedNotice": ["14:30"],
  "devices.seen": ["Today, 8:00", "100.64.0.7"],
  "devices.removeTitle": ["iPhone · Safari"],
  "settings.security.unlockedUntil": ["14:30"],
  "settings.security.minutes": [5],
  "viewer.closed.unreachable.text": ["Amuse 的电脑"],
  "sandbox.description": ["Amuse 的电脑"],
  "sandbox.resetTitle": ["Amuse 的电脑"],
  "sandbox.resetFolder": ["myapp"],
  "sandbox.resetRepository": ["myapp"],
};

test("the Chinese catalog has every message the English one has", () => {
  assert.deepEqual(
    messages(zhCN).map(([key]) => key),
    messages(en).map(([key]) => key),
  );
});

test("every Chinese message is said: text is not empty, and a message that takes values says something for it", () => {
  const unsampled = messages(zhCN)
    .filter(([key, value]) => typeof value === "function" && !samples[key])
    .map(([key]) => key);
  assert.deepEqual(unsampled, [], "these take values: add sample values for them to this test");
  for (const [key, value] of messages(zhCN)) {
    if (typeof value === "string") {
      assert.notEqual(value.trim(), "", key);
    } else if (typeof value === "function") {
      const said: unknown = Reflect.apply(value, undefined, samples[key] ?? []);
      assert.equal(typeof said, "string", key);
      assert.notEqual(String(said).trim(), "", key);
    } else {
      assert.fail(`${key} is neither text nor a function of values`);
    }
  }
});
