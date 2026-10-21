import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = resolve(__dirname, "..");
const source = (relativePath: string) => readFileSync(resolve(appRoot, relativePath), "utf8");

describe("request type UI contract", () => {
  it("keeps the legacy value out of request UI and routes inserts through the compatibility boundary", () => {
    const employeeForm = source("app/(app)/requests/new/page.tsx");
    const portalForm = source("app/(portal)/client-portal/requests/new/page-client.tsx");
    const requestDetail = source("app/(app)/requests/[id]/page.tsx");

    expect(employeeForm).toContain("legacyRequestTypeForInsert()");
    expect(portalForm).toContain("legacyRequestTypeForInsert()");
    expect(`${employeeForm}\n${portalForm}\n${requestDetail}`).not.toMatch(/request_type\s*===|request_type:\s*["']/);
    expect(`${employeeForm}\n${portalForm}\n${requestDetail}`).not.toContain("rental");
  });

  it("keeps the portal journey progressive through atomic creation and same-draft submission", () => {
    const portalForm = source("app/(portal)/client-portal/requests/new/page-client.tsx");
    const en = source("lib/translations/en.ts");
    const ar = source("lib/translations/ar.ts");

    expect(portalForm).toContain("const [step, setStep] = useState(1)");
    expect(portalForm).toContain("tp.requestSteps.need");
    expect(portalForm).toContain("tp.requestSteps.project");
    expect(portalForm).toContain("tp.requestSteps.dates");
    expect(portalForm).toContain("tp.requestSteps.review");
    expect(portalForm).toContain("step === 4 &&");
    expect(portalForm).toContain("createPortalDraftOperation({");
    expect(portalForm).toContain("submitPortalDraft(id, actorId)");
    expect(portalForm).not.toContain("portalAddItem(");
    for (const copy of [en, ar]) {
      expect(copy).toContain("requestSteps:");
      expect(copy).toContain("previousStep:");
      expect(copy).toContain("nextStep:");
    }
  });
});
