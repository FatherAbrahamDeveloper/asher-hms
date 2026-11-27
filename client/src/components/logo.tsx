/** Hotel logo. "light" is for dark backgrounds (header, sidebar); "dark" for white pages and print. */
export function Logo({ variant = "dark", className = "h-10", alt = "Asher Hotel and Suites" }: { variant?: "light" | "dark"; className?: string; alt?: string }) {
  return <img src={variant === "light" ? "/logo-light.png" : "/logo.png"} alt={alt} className={`w-auto object-contain ${className}`} />;
}
