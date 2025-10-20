import crypto from "crypto";

const password = "392002Planes0.";
const pepper = "3f8b1c6e5d9a47f8c2b0e3d1a9f6c7e48b2f9d3a7c1e5f0a4d8b7e2c6f3a9d0e";

const hash = crypto
  .createHash("sha256")
  .update(password + pepper)
  .digest("hex");

console.log("Hash calculado:", hash);
