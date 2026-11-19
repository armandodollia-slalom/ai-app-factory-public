using System.Net;
using System.Net.Http;

class Clients
{
    void Bad()
    {
        var h = new HttpClientHandler();
        // ruleid: factory.cs.tls-verification-off
        h.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;
        // ruleid: factory.cs.tls-verification-off
        var h2 = new HttpClientHandler { ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator };
        // ruleid: factory.cs.tls-verification-off
        ServicePointManager.ServerCertificateValidationCallback = (s, c, ch, e) => true;
    }

    void Good()
    {
        // ok: factory.cs.tls-verification-off
        var h = new HttpClientHandler { CheckCertificateRevocationList = true };
    }
}
