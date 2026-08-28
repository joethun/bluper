import { ThemeProvider } from "next-themes";
import "./globals.css";
import Script from "next/script";
import { Toaster } from "../components/ui/sonner";
import { TOOLTIP_DELAY_MS, TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { Inter } from "next/font/google";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className={`${siteFont.className} font-sans antialiased`}>
				{process.env.NODE_ENV === "development" ? (
					<Script
						src="//unpkg.com/react-scan/dist/auto.global.js"
						crossOrigin="anonymous"
						strategy="beforeInteractive"
					/>
				) : null}
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
						<Toaster />
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
