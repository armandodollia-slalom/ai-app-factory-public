using System;
using System.Security.Cryptography;

class Tokens
{
    string Bad()
    {
        var rng = new Random();
        // ruleid: factory.cs.insecure-random-secret
        var resetCode = rng.Next(100000, 999999).ToString();
        // ruleid: factory.cs.insecure-random-secret
        int otp = Random.Shared.Next(1000000);
        return resetCode + otp;
    }

    string Good()
    {
        var rng = new Random();
        // ok: factory.cs.insecure-random-secret
        var delayMs = rng.Next(100);
        // ok: factory.cs.insecure-random-secret
        var resetCode = RandomNumberGenerator.GetInt32(100000, 999999).ToString();
        return resetCode + delayMs;
    }
}
