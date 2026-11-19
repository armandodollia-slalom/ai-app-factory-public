using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

class Orders
{
    void Bad(SqlConnection conn, DbContext db, string id)
    {
        // ruleid: factory.cs.sql-string-built
        var cmd = new SqlCommand($"SELECT * FROM Orders WHERE Id = {id}", conn);
        // ruleid: factory.cs.sql-string-built
        db.Database.ExecuteSqlRaw("DELETE FROM Carts WHERE Owner = '" + id + "'");
        // ruleid: factory.cs.sql-string-built
        cmd.CommandText = "SELECT 1 WHERE x = " + id;
    }

    void Good(SqlConnection conn, DbContext db, string id)
    {
        // ok: factory.cs.sql-string-built
        var cmd = new SqlCommand("SELECT * FROM Orders WHERE Id = @id", conn);
        cmd.Parameters.AddWithValue("@id", id);
        // ok: factory.cs.sql-string-built
        db.Database.ExecuteSql($"DELETE FROM Carts WHERE Owner = {id}");
        // ok: factory.cs.sql-string-built
        var uri = new System.Uri($"http://catalog/api/items/{id}");
        // ok: factory.cs.sql-string-built
        var error = new System.ArgumentException($"No order {id}");
        // ruleid: factory.cs.sql-string-built
        var adapter = new Npgsql.NpgsqlCommand("SELECT * FROM orders WHERE id = " + id);
    }
}
