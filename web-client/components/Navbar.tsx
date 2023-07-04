"use client";

import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useState } from "react";

import { auth, signInWithGoogle, signOutUser, type User } from "@/lib/firebase";

export default function Navbar() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  return (
    <header className="navbar">
      <Link href="/" className="logo">
        <span className="logo-mark">▶</span> Tube
      </Link>
      <nav>
        {user && (
          <Link href="/upload" className="button ghost">
            Upload
          </Link>
        )}
        {user ? (
          <button className="button" onClick={() => signOutUser()}>
            Sign out
          </button>
        ) : (
          <button className="button" onClick={() => signInWithGoogle().catch(console.error)}>
            Sign in
          </button>
        )}
      </nav>
    </header>
  );
}
