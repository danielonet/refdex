package com.acme.service;

import com.acme.model.Invoice;
import com.acme.model.Invoice.Line;
import com.acme.model.*;
import static com.acme.util.Strings.join;
import java.util.List;

public class InvoiceService {
    public Invoice find(String id) { return null; }
    public Invoice find(String id, boolean drafts) { return null; }
    private List<Line> lines() { return null; }
}
