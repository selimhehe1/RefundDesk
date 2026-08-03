import { Box } from "@stripe/ui-extension-sdk/ui";

/**
 * A consistent visual section marker.
 *
 * Deliberately not called a heading in the accessibility sense: the extension toolkit
 * exposes no `role`, `aria-level` or any other ARIA prop, so nothing here reaches the
 * accessibility tree as a heading and no heading-based navigation becomes available.
 * The semantic anchors remain the `title`/`description` props of the official
 * `ContextView`, `SettingsView` and `OnboardingView` shells.
 */
export function SectionHeading({ children }: { readonly children: string }) {
  return <Box css={{ font: "subheading" }}>{children}</Box>;
}
