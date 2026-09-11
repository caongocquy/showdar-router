import { NextResponse } from "next/server";
import { modelDiscovery } from "./service.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const providerId = searchParams.get("providerId");

  if (!providerId) {
    return NextResponse.json({ error: "Missing providerId" }, { status: 400 });
  }

  try {
    return NextResponse.json({ data: await modelDiscovery.discover(providerId) });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Model discovery unavailable" }, { status: error.status || 500 });
  }
}
