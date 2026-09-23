global using System.Linq;
using System;
using System.Collections.Generic;

namespace Example.Crm;

public partial class Customer : IComparable<Customer>
{
    private readonly List<string> _tags = new();
    public const int MaxTags = 10;

    public Guid Id { get; init; }
    public string Name { get; set; } = "";

    public Customer(string name) => Name = name;

    public int CompareTo(Customer? other) => string.Compare(Name, other?.Name, StringComparison.Ordinal);

    public partial void OnRenamed(string oldName);
}

public record struct Address(string Street, string City);

public interface ICustomerRepository
{
    Customer? Find(Guid id);
}

public enum Tier { Bronze, Silver, Gold }

public static class CustomerExtensions
{
    public static bool IsVip(this Customer c) => c.Name.StartsWith("VIP");
}
