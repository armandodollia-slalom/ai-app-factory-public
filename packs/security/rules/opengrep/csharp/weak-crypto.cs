using System.Security.Cryptography;

class Hashing
{
    void Bad(byte[] data, Aes aes)
    {
        // ruleid: factory.cs.weak-crypto
        using var md5 = MD5.Create();
        // ruleid: factory.cs.weak-crypto
        var h = SHA1.HashData(data);
        // ruleid: factory.cs.weak-crypto
        aes.Mode = CipherMode.ECB;
        // ruleid: factory.cs.weak-crypto
        using var des = TripleDES.Create();
    }

    void Good(byte[] data, Aes aes)
    {
        // ok: factory.cs.weak-crypto
        var h = SHA256.HashData(data);
        // ok: factory.cs.weak-crypto
        aes.Mode = CipherMode.CBC;
    }
}
