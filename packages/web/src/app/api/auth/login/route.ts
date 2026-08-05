import { NextResponse } from 'next/server';
import { completeLogin } from '@/lib/login-flow';

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  return completeLogin(email, password);
}
