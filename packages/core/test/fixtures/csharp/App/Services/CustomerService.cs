using System;
using static Acme.Domain.Guard;
using Repo = Acme.Domain.ICustomerRepository;

namespace Acme.Services;

public class CustomerService
{
    /// <summary>
    /// Creates a customer.
    /// </summary>
    public Customer Create(string name) => new Customer { Name = name };
}
