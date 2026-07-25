export default function PilotHome() {
  return (
    <main style={{ maxWidth: 720, margin: "80px auto", padding: 32 }}>
      <p style={{ color: "#635bff", fontWeight: 700, letterSpacing: 0.5 }}>REFUNDDESK</p>
      <h1>Sandbox pilot backend</h1>
      <p>
        RefundDesk requires approval for refunds initiated through the app, records workflow
        decisions, and flags refunds detected outside it.
      </p>
      <p>
        This environment is not a public product site. Live refunds, Billing, e-mail, and
        Marketplace publication are disabled.
      </p>
    </main>
  );
}
