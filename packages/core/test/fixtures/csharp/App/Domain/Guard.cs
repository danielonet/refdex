namespace Acme.Domain;

public static class Guard
{
    public static void NotNull(object value) { }
}

public interface ICustomerRepository
{
    Customer? Find(int id);
}
