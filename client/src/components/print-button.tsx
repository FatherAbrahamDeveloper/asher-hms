export function PrintButton({ label = "Download / Print PDF" }: { label?: string }) {
  return <button className="btn-primary" onClick={() => window.print()}>{label}</button>;
}
