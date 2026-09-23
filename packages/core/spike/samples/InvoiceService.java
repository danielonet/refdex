package com.example.billing;

import java.util.List;
import java.util.*;
import static java.util.Objects.requireNonNull;

public class InvoiceService implements AutoCloseable {
    private static final int MAX_LINES = 500;
    private final List<Invoice> invoices = new ArrayList<>();

    public InvoiceService() {}

    public InvoiceService(List<Invoice> seed) {
        invoices.addAll(requireNonNull(seed));
    }

    public Invoice find(String id) { return null; }

    public Invoice find(String id, boolean includeDrafts) { return null; }

    @Override
    public void close() {}

    public static class Builder {
        public InvoiceService build() { return new InvoiceService(); }
    }

    public record Invoice(String id, long cents) {}

    enum Status { DRAFT, SENT, PAID }
}

interface Auditable {
    void audit(String who);
}
