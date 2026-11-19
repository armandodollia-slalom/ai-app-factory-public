using System.Runtime.Serialization.Formatters.Binary;
using Newtonsoft.Json;

class Loader
{
    object Bad(System.IO.Stream s, JsonSerializerSettings settings)
    {
        // ruleid: factory.cs.unsafe-deserialization
        var f = new BinaryFormatter();
        // ruleid: factory.cs.unsafe-deserialization
        var opts = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.All };
        // ruleid: factory.cs.unsafe-deserialization
        settings.TypeNameHandling = TypeNameHandling.Auto;
        return f.Deserialize(s);
    }

    void Good(JsonSerializerSettings settings)
    {
        // ok: factory.cs.unsafe-deserialization
        settings.TypeNameHandling = TypeNameHandling.None;
        // ok: factory.cs.unsafe-deserialization
        var x = System.Text.Json.JsonSerializer.Deserialize<int>("1");
    }
}
