import { localSigner } from "./local-signer.mjs";
export function signingOptions() {
  if (process.env.HUIXIANG_SIGN_IDENTITY)
    return ["--sign", process.env.HUIXIANG_SIGN_IDENTITY];
  const signer = localSigner();
  return ["--keychain", signer.keychain, "--sign", signer.identity];
}
